pragma solidity 0.7.6;
pragma abicoder v2;

interface IClearingHouse {

	struct Asset {
		uint balance; 
		uint debt;
		uint fee;
	}

	struct OpenOrder {
		uint liquidity;
		uint24 tickLower;
		uint24 tickUpper;
        uint128 feeGrowthInsideLastBaseX128;
		uint128 feeGrowthInsideLastQuoteX128;
	}


    struct Account {
		uint margin;
		
		// key: vToken
		mapping(address => Asset) assetMap;
		// key: vToken, value: UniV3 pool
		mapping(address => address[]) tokenPoolsMap;
		
		// maker only
		address pools[];
        // key: pool address, value: array of order ids
		mapping(address => uint[]) makerPositionMap;
    }

	function deposit(uint _amount) external;	

	// trader's function
	function removeMargin(uint _margin) external;
	function openPosition(
			address _pool, 
			Side _side, 
			uint _quote, 
			uint baseLimit
		) external returns(uint base);
	function closePosition(address _pool, uint _quoteLimit) external returns(uint quote, uint base);
	function liquidate(address _pool, address _taker) external returns(uint base);

	// maker's function
	function mint(address _asset, uint _amount) external;
	function burn(address _asset, uint _amount) external;
	function addLiquidity(
			address _pool, 
			uint _base, 
			uint _minBase,
			uint _quote,
			uint _minQuote,
			uint _tickLower, 
			uint _tickUpper
		) external returns(uint liquidity, uint baseDelta, uint quoteDelta);
	function removeLiquidity(address _pool, uint _orderId, uint _liquidity) external returns(uint liquidity, uint baseDelta, uint quoteDelta, uint pnl);
	function cancelExcessOpenOrder(address _pool, address _maker, uint _orderId, uint _liquidity) external;
	function collect(address _pool, uint _orderId) returns(uint feeBase, uint feeQuote) external;

}
