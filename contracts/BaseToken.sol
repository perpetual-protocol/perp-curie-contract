pragma solidity 0.7.6;
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

interface IPriceFeed {
    function decimals() external view returns (uint256);

    function getPrice() external view returns (uint256);

    function getTwapPrice(uint256 _interval) external view returns (uint256);
}

contract ChainlinkPriceFeed is IPriceFeed {
    using SafeMath for uint256;

    AggregatorV3Interface private immutable _aggregator;

    constructor(AggregatorV3Interface aggregator) {
        // BT_IA: invalid address
        require(address(aggregator) != address(0), "BT_IA");

        _aggregator = aggregator;
    }

    function decimals() external view override returns (uint256) {
        return _aggregator.decimals();
    }

    function getPrice() external view override returns (uint256) {
        (, uint256 latestPrice, ) = _getLatestRoundData();
        return latestPrice;
    }

    function getTwapPrice(uint256 _interval) external view override returns (uint256) {
        // BT_II: invalid interval
        require(_interval != 0, "BT_II");

        // 3 different timestamps, `previous`, `current`, `target`
        // `base` = now - _interval
        // `current` = current round timestamp from aggregator
        // `previous` = previous round timestamp form aggregator
        // now >= previous > current > = < base
        //
        //  while loop i = 0
        //  --+------+-----+-----+-----+-----+-----+
        //         base                 current  now(previous)
        //
        //  while loop i = 1
        //  --+------+-----+-----+-----+-----+-----+
        //         base           current previous now

        (uint80 round, uint256 latestPrice, uint256 latestTimestamp) = _getLatestRoundData();
        uint256 baseTimestamp = block.timestamp.sub(_interval);
        // if latest updated timestamp is earlier than target timestamp, return the latest price.
        if (latestTimestamp < baseTimestamp || round == 0) {
            return latestPrice;
        }

        // rounds are like snapshots, latestRound means the latest price snapshot. follow chainlink naming
        uint256 previousTimestamp = latestTimestamp;
        uint256 cumulativeTime = block.timestamp.sub(previousTimestamp);
        uint256 weightedPrice = latestPrice.mul(cumulativeTime);
        while (true) {
            if (round == 0) {
                // if cumulative time is less than requested interval, return current twap price
                return weightedPrice.div(cumulativeTime);
            }

            round = round - 1;
            (, uint256 currentPrice, uint256 currentTimestamp) = _getRoundData(round);

            // check if current round timestamp is earlier than target timestamp
            if (currentTimestamp <= baseTimestamp) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, _interval is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice.add(currentPrice.mul(previousTimestamp.sub(baseTimestamp)));
                break;
            }

            uint256 timeFraction = previousTimestamp.sub(currentTimestamp);
            weightedPrice = weightedPrice.add(currentPrice.mul(timeFraction));
            cumulativeTime = cumulativeTime.add(timeFraction);
            previousTimestamp = currentTimestamp;
        }
        return weightedPrice.div(_interval);
    }

    function _getLatestRoundData()
        private
        view
        returns (
            uint80,
            uint256 finalPrice,
            uint256
        )
    {
        (uint80 round, int256 latestPrice, , uint256 latestTimestamp, ) = _aggregator.latestRoundData();
        finalPrice = uint256(latestPrice);
        if (latestPrice < 0) {
            requireEnoughHistory(round);
            (round, finalPrice, latestTimestamp) = _getRoundData(round - 1);
        }
        return (round, finalPrice, latestTimestamp);
    }

    function _getRoundData(uint80 _round)
        private
        view
        returns (
            uint80,
            uint256,
            uint256
        )
    {
        (uint80 round, int256 latestPrice, , uint256 latestTimestamp, ) = _aggregator.getRoundData(_round);
        while (latestPrice < 0) {
            requireEnoughHistory(round);
            round = round - 1;
            (, latestPrice, , latestTimestamp, ) = _aggregator.getRoundData(round);
        }
        return (round, uint256(latestPrice), latestTimestamp);
    }

    function requireEnoughHistory(uint80 _round) internal pure {
        require(_round > 0, "Not enough history");
    }
}

// TODO: Ownable
// TODO: only keep what we need in ERC20PresetMinterPauser
contract BaseToken is ERC20PresetMinterPauser {
    using SafeMath for uint256;
    IPriceFeed private immutable _priceFeed;
    uint256 private immutable _priceFeedDecimals;

    constructor(
        string memory name,
        string memory symbol,
        IPriceFeed priceFeed
    ) ERC20PresetMinterPauser(name, symbol) {
        // BT_IA: invalid address
        require(address(priceFeed) != address(0), "BT_IA");

        _priceFeed = priceFeed;
        _priceFeedDecimals = priceFeed.decimals();
    }

    // TODO: onlyOwner
    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    // TODO: rename to getOraclePrice()
    function getPrice() external view returns (uint256) {
        return _formatDecimals(_priceFeed.getPrice());
    }

    function getTwapPrice(uint256 _interval) external view returns (uint256) {
        return _formatDecimals(_priceFeed.getTwapPrice(_interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**decimals()).div(10**uint256(_priceFeed.decimals()));
    }
}
