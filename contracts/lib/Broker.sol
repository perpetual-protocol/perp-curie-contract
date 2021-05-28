pragma solidity 0.7.6;
pragma abicoder v2;


library Broker {

	function addLiquidity (
        address _pool, 
        int24 _tickLower,
        int24 _tickUpper,
        uint256 _base,
        uint256 _quote
	) internal returns (uint base,
            uint quote,
            uint liquidityDelta,
            uint feeCumulativePerLiquidityBase,
            uint feeCumulativePerLiquidityQuote){
                revert(); 
            }

	function removeLiquidity (
		address _pool,
        int24 _tickLower,
        int24 _tickUpper,
		uint _liquidity
	) internal returns (
        uint base,
        uint quote,
        uint liquidityDelta,
        uint feeCumulativePerLiquidityBase,
        uint feeCumulativePerLiquidityQuote) {
                revert(); 
            }

	function swap(
        address _pool,
        bool _baseToQuote,
        bool _exactInput,
        uint _amount,
        uint _exchangedAmountLimit
    ) internal returns (uint256 base, uint256 quote) {
                revert(); 
            }

	function collectFee(address _pool, int _tickLower, int _tickUpper) internal returns(uint feeBase, uint feeQuote){
                revert(); 
            }

	// view functions
	function getAmountsForLiquidity (
			address _pool, 
			uint24 _tickLower, 
			uint24 _tickUpper, 
			uint _liquidty
		) internal view returns(uint base, uint quote){
                revert(); 
            }

	function getQuoteToBase(address _pool, bool _exactQuote, uint256 _amount) internal view returns(uint base){
                revert(); 
            }
	function getBaseToQuote(address _pool, bool _exactBase, uint256 _amount) internal view returns(uint quote){
                revert(); 
            }

}
